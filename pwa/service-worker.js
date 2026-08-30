// pwa/service-worker.js
//
// Service Worker Pilotéo Next — docs/next/01_CDC_LOCAL_FIRST.md §18 (PWA),
// docs/next/02_ARCHITECTURE_CIBLE.md §14 (hébergement statique, HTTPS requis),
// docs/next/05_SECURITE_CRYPTO_IDENTITE.md §12 (distribution PWA : « pas de
// mise à jour silencieuse au milieu d'une session critique »),
// docs/next/07_TESTS_ET_RECETTE.md §10 (tests PWA).
//
// Script SW natif navigateur : PAS de `import`/`export` ES module, PAS de
// dépendance npm. Ce fichier est servi tel quel, à la racine du scope PWA
// (voir pwa/README.md pour le câblage exact).
//
// Décisions :
// - HTTPS obligatoire : un Service Worker ne s'enregistre pas sur `file://`
//   ni sur `http://` (sauf `http://localhost` en dev). Voir pwa/README.md.
// - Cache versionné : `CACHE_VERSION` doit être incrémenté à CHAQUE
//   déploiement changeant un asset précaché. Un changement de version crée un
//   nouveau nom de cache ; l'ancien n'est jamais réécrit en place (cohérent
//   avec l'esprit « write-once » du reste de l'architecture).
// - Precache paramétrable : `PRECACHE_URLS` ci-dessous est la liste d'assets
//   statiques à mettre en cache à l'installation. Un déploiement réel doit
//   RÉGÉNÉRER cette liste (chemins + éventuel hash de build) — c'est le point
//   à automatiser dans un futur build PWA. Un chemin absent renvoie une
//   erreur `cache.addAll` : garder la liste synchronisée avec les fichiers
//   réellement servis.
// - Pas de mise à jour silencieuse en cours de session : `install` NE fait
//   PAS `self.skipWaiting()`. Le nouveau SW reste `waiting` tant que l'appli
//   (via `register-sw.js`) n'envoie pas explicitement le message
//   `{type:"SKIP_WAITING"}` (typiquement suite à une action utilisateur du
//   type « Une nouvelle version est disponible — recharger »).
// - `activate` nettoie les caches d'une version PRÉCÉDENTE de ce même SW
//   (préfixe `STATIC_CACHE_PREFIX`) uniquement — jamais les caches d'une
//   autre origine ou d'un autre usage.
// - Stratégie réseau :
//     - assets statiques même origine (précachés ou non, hors `/api/`) :
//       cache-first avec revalidation en arrière-plan (stale-while-revalidate
//       douce) — sert vite, se met à jour silencieusement en cache pour la
//       PROCHAINE visite, jamais en remplaçant ce qui est déjà affiché ;
//     - requêtes `/api/*` (données) : toujours réseau, jamais de cache — la
//       V1 sert de source de vérité tant que Phase 1/2 ne l'ont pas remplacée
//       par LocalStore (voir src/integration/localstore-bridge.js) ; en cas
//       d'échec réseau, l'erreur remonte telle quelle à l'appelant (pas de
//       fausse réponse offline sur des données métier) ;
//     - navigations (`mode:"navigate"`) : réseau d'abord, repli sur le shell
//       précaché si hors ligne, pour permettre l'ouverture offline après un
//       premier chargement (CDC §18).

const CACHE_VERSION = "v1";
const STATIC_CACHE_PREFIX = "piloteo-static-";
const CACHE_NAME = `${STATIC_CACHE_PREFIX}${CACHE_VERSION}`;

// À régénérer par le build/déploiement (voir pwa/README.md). Chemins relatifs
// au scope du Service Worker. `./` doit résoudre vers la coquille (index.html
// de la PWA ou une page d'accueil dédiée next — voir README).
const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // best-effort : un asset manquant ne doit pas empêcher l'installation
      // des autres (addAll est tout-ou-rien, donc on retombe sur put() unitaire).
      await Promise.all(
        PRECACHE_URLS.map(async (url) => {
          try {
            const response = await fetch(url, { cache: "no-store" });
            if (response && response.ok) {
              await cache.put(url, response.clone());
            }
          } catch {
            // Hors ligne à l'installation, ou asset absent : ignoré, précaché
            // au prochain succès réseau via la revalidation en arrière-plan.
          }
        }),
      );
      // PAS de self.skipWaiting() ici : le nouveau SW reste `waiting`.
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(STATIC_CACHE_PREFIX) && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

// Déclenché explicitement par l'app (register-sw.js) suite à une action
// utilisateur volontaire — jamais automatiquement. Voir docs/next/05 §12.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

function isApiRequest(url) {
  return url.pathname.startsWith("/api/");
}

async function networkOnly(request) {
  // Pas de cache pour les données : la fraîcheur/les droits priment.
  return fetch(request);
}

async function cacheFirstWithRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const networkFetch = fetch(request)
    .then((response) => {
      if (response && response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  if (cached) {
    // Sert le cache immédiatement ; la revalidation réseau alimente le cache
    // pour la prochaine requête, sans jamais remplacer ce qui est déjà rendu.
    event_noop(networkFetch);
    return cached;
  }
  const fresh = await networkFetch;
  if (fresh) return fresh;
  throw new Error("service-worker: ressource indisponible (hors ligne et non précachée)");
}

// Évite un rejet non géré sur la promesse de revalidation en arrière-plan.
function event_noop(promise) {
  promise.catch(() => {});
}

async function navigationFallback(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(CACHE_NAME);
    const shell = (await cache.match("./index.html")) || (await cache.match("./"));
    if (shell) return shell;
    throw new Error("service-worker: navigation hors ligne sans shell précaché");
  }
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return; // laisse passer POST/PUT/DELETE (ex. sync réseau) sans interception

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // aucune interception cross-origin (pas de CDN requis, CDC §18)

  if (isApiRequest(url)) {
    event.respondWith(networkOnly(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(navigationFallback(request));
    return;
  }

  event.respondWith(cacheFirstWithRevalidate(request));
});
