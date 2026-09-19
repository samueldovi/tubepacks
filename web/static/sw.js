/* TubePacks — service worker : coquille en cache, données toujours au réseau.

   Les pages et les fichiers statiques sont servis depuis le cache après la première
   visite (démarrage instantané, y compris hors ligne). Tout ce qui est sous /api/
   passe exclusivement par le réseau : on ne sert jamais un solde ou une enchère périmés.
*/
const VERSION = "tubepacks-v2";   // à incrémenter à chaque changement d'interface
const SHELL = [
  "/",
  "/static/app.css",
  "/static/app.js",
  "/static/manifest.webmanifest",
  "/static/icon-192.png",
  "/static/icon-512.png",
  "/static/offline.html",
];

self.addEventListener("install", e => {
  // addAll échouerait en bloc sur un seul fichier manquant : on met en cache un par un.
  e.waitUntil(caches.open(VERSION)
    .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("message", e => {
  if (e.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;        // miniatures YouTube, polices…
  if (url.pathname.startsWith("/api/")) return;           // jamais de données en cache

  // Navigation : le réseau d'abord (l'app doit rester à jour), le cache en secours.
  if (req.mode === "navigate") {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put("/", copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match("/").then(r => r || caches.match("/static/offline.html")))
    );
    return;
  }

  // Fichiers statiques : le cache d'abord, rafraîchi en arrière-plan.
  e.respondWith(caches.match(req).then(hit => {
    const net = fetch(req).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(VERSION).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
