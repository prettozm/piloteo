/* sw-solo.js — Service Worker du mode SOLO Pilotéo (Phase 2B).
 *
 * Rend l'application utilisable HORS LIGNE après le premier chargement : il met
 * en cache la coquille statique (index.html, app.js, local-backend.js, seed.json,
 * manifeste). Les données métier, elles, ne passent jamais par le réseau en solo
 * (local-backend.js répond à /api/* depuis IndexedDB, dans la page) — le SW n'a
 * donc pas à toucher /api.
 *
 * Enregistré uniquement en mode solo (par local-backend.js). Politique de MAJ
 * contrôlée : pas de skipWaiting automatique ; un nouveau SW attend.
 */
var CACHE_VERSION = "piloteo-solo-v1";
var PRECACHE = [
  "/",
  "/index.html",
  "/app.js",
  "/local-backend.js",
  "/seed.json",
  "/manifest.webmanifest"
];

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function (cache) {
      // addAll échoue si un asset manque ; on tolère les optionnels un par un.
      return Promise.all(PRECACHE.map(function (url) {
        return cache.add(url).catch(function () { /* asset optionnel absent : ignoré */ });
      }));
    })
  );
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) {
        return k !== CACHE_VERSION && k.indexOf("piloteo-solo-") === 0;
      }).map(function (k) { return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (event) {
  var req = event.request;
  if (req.method !== "GET") return;                 // écritures : rien à mettre en cache
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // tiers : réseau normal
  if (url.pathname.indexOf("/api/") === 0) return;  // données : gérées en page, jamais réseau

  if (req.mode === "navigate") {
    // Navigation : réseau d'abord, repli sur la coquille cachée si hors ligne.
    event.respondWith(
      fetch(req).catch(function () {
        return caches.match("/index.html").then(function (r) { return r || caches.match("/"); });
      })
    );
    return;
  }
  // Statique : cache d'abord, puis réseau (et on met en cache au passage).
  event.respondWith(
    caches.match(req).then(function (hit) {
      if (hit) return hit;
      return fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(CACHE_VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      });
    })
  );
});
