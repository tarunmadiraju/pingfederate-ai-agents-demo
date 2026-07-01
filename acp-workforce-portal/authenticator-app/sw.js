/**
 * Authenticator App — Service Worker
 *
 * Network-first for everything — ensures deploys take effect immediately.
 * Falls back to cache only when offline.
 */

const CACHE_NAME = 'authenticator-v3';
const SHELL_ASSETS = [
    '/authenticator-app/',
    '/authenticator-app/app.js',
];

// Install — pre-cache app shell, activate immediately
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
    );
    self.skipWaiting();
});

// Activate — clean old caches, claim clients immediately
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Fetch — network-first, cache fallback (offline only)
self.addEventListener('fetch', (event) => {
    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // Update cache with fresh response
                if (response.ok) {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
                }
                return response;
            })
            .catch(() => caches.match(event.request))
    );
});
