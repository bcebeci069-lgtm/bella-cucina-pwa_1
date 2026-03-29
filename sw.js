// ═══════════════════════════════════════════
// Bella Cucina — Service Worker
// Ermöglicht: Offline-Modus, schnelles Laden,
// App-Installation auf dem Homescreen
// ═══════════════════════════════════════════

const CACHE_NAME = 'bella-cucina-v1';

// Diese Dateien werden beim ersten Start gespeichert
// → App funktioniert danach auch ohne Internet
const CACHE_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700;900&family=DM+Sans:wght@300;400;500;600&display=swap',
];

// ── Installation: Dateien cachen ─────────────
self.addEventListener('install', event => {
  console.log('[SW] Installiere...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(CACHE_FILES);
    })
  );
  // Sofort aktiv werden (kein Warten auf alten SW)
  self.skipWaiting();
});

// ── Aktivierung: Alten Cache löschen ─────────
self.addEventListener('activate', event => {
  console.log('[SW] Aktiviert');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ── Requests abfangen ────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // API-Calls (Bestellungen) → IMMER live, nie aus Cache
  if (url.pathname.startsWith('/api/')) {
    return; // Direkt ans Netzwerk
  }

  // POST-Requests nicht cachen
  if (request.method !== 'GET') return;

  // Alles andere: erst Cache, dann Netzwerk (schnell!)
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request).then(response => {
        // Nur gültige Antworten cachen
        if (!response || response.status !== 200 || response.type === 'opaque') {
          return response;
        }
        const copy = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
        return response;
      }).catch(() => {
        // Offline-Fallback: Hauptseite anzeigen
        if (request.destination === 'document') {
          return caches.match('/index.html');
        }
      });
    })
  );
});

// ── Push Notifications (optional) ────────────
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json();
  self.registration.showNotification(data.title || 'Bella Cucina', {
    body:    data.body || 'Ihre Bestellung ist unterwegs!',
    icon:    '/icons/icon-192.png',
    badge:   '/icons/icon-72.png',
    vibrate: [200, 100, 200],
    data:    { url: data.url || '/' },
    actions: [
      { action: 'track', title: 'Verfolgen' },
      { action: 'close', title: 'Schließen' }
    ]
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  if (event.action === 'track') {
    clients.openWindow('/#tracking');
  }
});
