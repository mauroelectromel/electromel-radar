/**
 * ELECTROMEL RADAR — Service Worker
 * sw.js · Versión física, sin blob:, sin hacks.
 *
 * Estrategia:
 *   - Cache-first para assets propios y CDN estático (Leaflet, fuentes)
 *   - Network-first con fallback offline para APIs externas (OSM, Google)
 *   - Skip-waiting: nuevo SW toma control inmediatamente al recargar
 *
 * Compatible con GitHub Pages (paths relativos).
 *
 * Para actualizar la cache: cambiá CACHE_VERSION.
 */

'use strict';

const CACHE_VERSION = 'electromel-radar-v6-r5';

/* -----------------------------------------------------------------------
   Assets para pre-cachear en install.
   Rutas relativas para compatibilidad con subdirectorios (GitHub Pages).
   ----------------------------------------------------------------------- */
const PRECACHE_ASSETS = [
  './',
  './index.html',
  './radar.css',
  './app.js',
  './manifest.json',
  /* CDN estático — versión fija para que el cache sea predecible */
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  /* Google Fonts — preconectado en HTML, cacheamos la respuesta */
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700;800&family=Barlow:wght@400;500;600;700;800;900&family=Barlow+Condensed:wght@600;700;800;900&display=swap'
];

/* -----------------------------------------------------------------------
   Dominios de APIs externas — tratar con network-first
   ----------------------------------------------------------------------- */
const NETWORK_FIRST_HOSTS = [
  'overpass-api.de',
  'overpass.kumi.systems',
  'overpass.private.coffee',
  'nominatim.openstreetmap.org',
  'maps.googleapis.com'
];

/* -----------------------------------------------------------------------
   Dominios de tiles OSM — network-first con fallback transparente
   (los tiles no se pre-cachean para no explotar el storage)
   ----------------------------------------------------------------------- */
const TILE_HOST_PATTERN = /tile\.openstreetmap\.org/;

/* =======================================================================
   INSTALL — Pre-cachea assets críticos
   ======================================================================= */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => {
        /* addAll falla si cualquier request falla.
           Para evitar que un CDN caído bloquee el install,
           cacheamos de a uno con manejo de errores. */
        return Promise.allSettled(
          PRECACHE_ASSETS.map(url =>
            cache.add(url).catch(err =>
              console.warn('[SW] No se pudo pre-cachear:', url, err.message)
            )
          )
        );
      })
      .then(() => {
        console.log('[SW] Install completado — cache:', CACHE_VERSION);
        /* Tomar control sin esperar que el usuario recargue */
        return self.skipWaiting();
      })
  );
});

/* =======================================================================
   ACTIVATE — Limpia caches viejas
   ======================================================================= */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys
          .filter(key => key !== CACHE_VERSION)
          .map(key => {
            console.log('[SW] Eliminando cache vieja:', key);
            return caches.delete(key);
          })
      ))
      .then(() => {
        console.log('[SW] Activate completado — controlando clientes');
        return self.clients.claim();
      })
  );
});

/* =======================================================================
   FETCH — Lógica de routing
   ======================================================================= */
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  /* Solo interceptar GET */
  if (req.method !== 'GET') return;

  /* Extensiones de Chrome, about:, etc — ignorar */
  if (!url.protocol.startsWith('http')) return;

  /* ---- Tiles OSM: network-first, sin guardar en cache (evita fill) ---- */
  if (TILE_HOST_PATTERN.test(url.hostname)) {
    event.respondWith(
      fetch(req)
        .catch(() => new Response('', { status: 503, statusText: 'Offline' }))
    );
    return;
  }

  /* ---- APIs externas: network-first, sin cache ---- */
  if (NETWORK_FIRST_HOSTS.includes(url.hostname)) {
    event.respondWith(
      fetch(req, { signal: AbortSignal.timeout(30000) })
        .catch(() =>
          new Response(
            JSON.stringify({ error: 'offline', elements: [] }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          )
        )
    );
    return;
  }

  /* ---- Assets propios y CDN estático: cache-first ---- */
  event.respondWith(cacheFirst(req));
});

/* =======================================================================
   Cache-first: intenta cache, si no hay va a red y cachea el resultado
   ======================================================================= */
async function cacheFirst(req) {
  try {
    const cached = await caches.match(req);
    if (cached) return cached;

    /* No está en cache — ir a la red */
    const networkRes = await fetch(req);

    /* Solo cachear respuestas exitosas y opaques (CDN cross-origin) */
    if (networkRes.ok || networkRes.type === 'opaque') {
      const cache = await caches.open(CACHE_VERSION);
      /* Clonar: el body solo se puede consumir una vez */
      cache.put(req, networkRes.clone()).catch(() => {
        /* Si la cache está llena, silenciar el error */
      });
    }

    return networkRes;
  } catch (err) {
    /* Sin red y sin cache — devolver respuesta de offline */
    console.warn('[SW] Fetch fallido, sin cache disponible:', req.url);

    /* Si es el HTML principal, intentar servir ./ como fallback */
    if (req.destination === 'document') {
      const fallback = await caches.match('./index.html')
        || await caches.match('./');
      if (fallback) return fallback;
    }

    return new Response(
      'ELECTROMEL RADAR — Sin conexión y sin cache disponible.',
      {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' }
      }
    );
  }
}

/* =======================================================================
   MENSAJE DESDE LA PÁGINA — para forzar skipWaiting desde la UI si se
   necesita en el futuro (opcional, no se usa hoy pero no rompe nada)
   ======================================================================= */
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
