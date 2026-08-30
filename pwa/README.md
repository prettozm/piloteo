# Pilotéo Next — Assets PWA & guide de câblage Phase 2

> Ce dossier contient les assets PWA (manifest, service worker, helper
> d'enregistrement) livrés en Phase 1/2 de
> `docs/next/03_MIGRATION_V1_VERS_LOCAL_FIRST.md`. **Aucun de ces fichiers
> n'est référencé par `index.html` aujourd'hui** : la V1 reste 100 % intacte.
> Ce document explique comment les brancher plus tard, sans toucher au métier
> de `app.js`.

## Contenu de ce lot

| Fichier | Rôle |
|---|---|
| `pwa/manifest.webmanifest` | Manifeste PWA (installabilité). Valeurs de marque = placeholders documentés en tête du fichier. |
| `pwa/service-worker.js` | Cache versionné, offline après premier chargement, mise à jour contrôlée (jamais silencieuse en session). |
| `pwa/register-sw.js` | Helper d'enregistrement + détection « mise à jour disponible » (pas d'auto-reload). |
| `src/integration/localstore-bridge.js` | Pont Phase 1 : miroir serveur→LocalStore + `chooseStartMode` pour l'écran de démarrage. |
| `tests/next/integration.test.mjs` | Tests `node:test` du pont ci-dessus. |

Ce qui **manque encore** et n'est PAS dans ce lot (voir « Ce qui reste à
faire » plus bas) : les 3 PNG d'icônes, une coquille HTML PWA dédiée
(`pwa/index.html` ou équivalent), le câblage réel dans `app.js`, et
`src/migration/v1-import.js` pour un import définitif (déjà existant dans
`src/migration/`, hors périmètre de ce lot d'assets).

---

## 1. Pré-requis incontournables

- **HTTPS obligatoire.** Un Service Worker ne s'enregistre pas sur `file://`,
  ni sur `http://` hors `http://localhost` (dev uniquement). WebCrypto
  (`crypto.subtle`, utilisé par `src/crypto/`) exige lui aussi un contexte
  sécurisé. Cible de production : `app.piloteo.fr` en hébergement statique
  (docs/next/02 §14).
- `pwa/register-sw.js` détecte lui-même l'absence de contexte sécurisé
  (`isSecureContext` / `"serviceWorker" in navigator`) et retourne
  `{registered:false, reason:"unsupported"}` sans lever d'exception — donc pas
  de crash sur `file://`, mais pas d'offline non plus.

## 2. Servir la coquille PWA statique

1. Déployer sur un hébergement statique HTTPS (ex. `app.piloteo.fr`) les
   fichiers suivants **à la racine du scope** souhaité :
   - `manifest.webmanifest`, `service-worker.js`, `register-sw.js` (ce dossier) ;
   - les 3 icônes déclarées dans le manifeste, à créer (`./icons/icon-192.png`,
     `./icons/icon-512.png`, `./icons/icon-maskable-512.png`) ;
   - la page d'accueil elle-même (`index.html` V1 aujourd'hui, ou une future
     coquille Next dédiée — voir §4).
2. Dans le `<head>` de la page servie, ajouter (nulle part encore fait dans
   `index.html` actuel, volontairement — voir contrainte V1 intacte) :
   ```html
   <link rel="manifest" href="./manifest.webmanifest">
   <meta name="theme-color" content="#0f172a">
   ```
3. Enregistrer le Service Worker et le helper d'update, typiquement en fin de
   page :
   ```html
   <script src="./register-sw.js"></script>
   <script>
     PiloteoSW.registerServiceWorker({
       swUrl: "./service-worker.js",
       onUpdateAvailable(reload) {
         // Afficher un bandeau non intrusif « Nouvelle version disponible » ;
         // n'appeler reload() que sur clic explicite de l'utilisateur.
         // Ne JAMAIS appeler reload() automatiquement (docs/next/05 §12 :
         // pas de mise à jour silencieuse en session).
       },
       onError(err) { console.warn("SW registration failed", err); },
     });
   </script>
   ```
4. Adapter `PRECACHE_URLS` en tête de `service-worker.js` à la liste réelle
   des assets statiques servis, et incrémenter `CACHE_VERSION` à chaque
   déploiement qui change un asset précaché (sinon les clients gardent
   l'ancienne version en cache indéfiniment).

Ceci ne modifie ni `app.js`, ni `index.html`, ni `server.py` existants : c'est
une nouvelle page/un nouveau déploiement statique qui les inclurait, pas une
édition en place de la V1.

## 3. Points de couture exacts dans `app.js` (Phase 1 → Solo)

D'après `src/V1_DOMAIN_MAP.md` §6, trois points précis, et rien d'autre à
toucher :

### a. `collectState()` — `app.js:528-534` — **source**

```js
function collectState(){
  return { consultants, organisations, affaires, methodes, typesTerritoire,
    domainesIntervention, categoriesFrais, missions, factures, saisies,
    bordereauxFrais, notesFrais };
}
```

Agrège déjà les 12 vars de module dans la forme attendue par
`mirrorServerState`. **Aucune modification requise** ici : c'est le point
qu'un futur appel viendrait *lire*, pas modifier.

### b. `applyRemoteState(state, rerender, markSynced)` — `app.js:554-577` — **sink**

Répartit un état reçu (serveur) vers les 12 vars. C'est le point d'insertion
naturel d'un appel `mirrorServerState` : juste après que `applyRemoteState`
ait appliqué un `state` d'origine serveur, un futur wrapper (PAS une édition
de cette fonction) appellerait :

```js
// (futur, hors app.js) après un applyRemoteState(data.state, ...) réussi :
await mirrorServerState(localStore, workspaceId, data.state);
```

Concrètement : ne pas modifier `applyRemoteState` elle-même ; envelopper ses
appelants (`syncNow()`, chargement initial) dans une fine couche
d'intégration qui, après coup, recopie le même `state` déjà appliqué vers
LocalStore. `applyRemoteState` reste le sink métier ; `mirrorServerState` est
un sink de *persistance locale* à côté, jamais une réécriture du premier.

### c. `syncNow()` — `app.js:730-777` — **couture réseau**

Aujourd'hui : `PUT /api/state` avec `{base_revision, state}` (état construit
par `collectState()`). C'est le point où, en Phase 3 (journal d'événements),
une file d'événements locale prendrait le relais de l'envoi direct de
snapshot. En Phase 1/2, ce point n'a besoin d'aucune modification : le miroir
(§b) suffit à faire cohabiter serveur et LocalStore sans changer la
sémantique réseau existante.

### d. Chargement initial — `startApp()` → `loadSessionState()` → `GET /api/state`

Point d'insertion de `loadMirroredState(localStore, workspaceId)` pour un
préchargement optimiste (afficher immédiatement le dernier miroir local
pendant que `GET /api/state` est en vol), strictement en complément — jamais
en remplacement — de la réponse serveur qui reste autoritaire en Phase 1.

### Comment brancher sans « chirurgie de `app.js` »

Le patron recommandé : un petit module d'intégration **séparé** (pas encore
créé — prochaine étape, hors périmètre de ce lot) qui :

1. importe `app.js` tel quel (ou s'exécute à côté, selon la structure de
   build retenue) ;
2. expose des hooks appelés depuis 2-3 lignes ajoutées à `app.js` aux points
   b/d ci-dessus (les seules lignes à toucher un jour dans `app.js`, et
   uniquement des *appels*, jamais une réécriture de la logique existante) ;
3. garde tout le reste (validation, décision offline/online, écran de
   démarrage) dans ce module séparé, testable indépendamment — comme
   `src/integration/localstore-bridge.js` l'est déjà ici.

## 4. Écran de démarrage à 3 choix

`src/integration/localstore-bridge.js` exporte `chooseStartMode(input)`,
fonction pure qui traduit le choix utilisateur (§4 de
`docs/next/01_CDC_LOCAL_FIRST.md`) en `"create" | "join" | "solo"`. Elle ne
fait aucun I/O : la future coquille d'accueil (Phase 2, pas encore créée)
l'appellerait après le clic sur un des 3 boutons, puis orchestrerait le
parcours correspondant (§4.1/4.2/4.3 de docs/next/01) en utilisant
`src/workspace/`, `src/crypto/`, `src/migration/v1-import.js` selon le cas —
aucun de ces modules n'est modifié ni appelé par ce lot.

## 5. Le pont `localstore-bridge.js` — ce qu'il fait / ne fait pas

**Fait :**
- `mirrorServerState(localStore, workspaceId, serverState)` : écrit
  `serverState` comme projection courante du workspace via
  `localStore.saveLocalProjection` (remplacement, pas de fusion).
- `loadMirroredState(localStore, workspaceId)` : relit cette projection (ou
  `null` si jamais écrite).
- `chooseStartMode(input)` : décide purement entre les 3 modes, invitation
  prioritaire sur l'intent, rejette (TypeError) toute entrée non conforme.

**Ne fait pas (volontairement, hors périmètre de ce lot) :**
- aucune validation structurelle du payload métier (CONTRACTS.md §2 — module
  séparé `events/validation.js`, déjà existant, non branché ici) ;
- aucune écriture dans `workspaces`/`memberships` (métadonnées de workspace —
  responsabilité de `src/workspace/`) ;
- aucun appel réseau, aucun accès DOM, aucune lecture de `app.js` ;
- aucune décision de conflit/concurrence (Phase 3, `events/conflict.js`) ;
- rien à l'import : toutes les fonctions sont inertes tant qu'un appelant ne
  les invoque pas explicitement (voir tête du fichier source pour le détail).

## 6. Ce qui reste à faire (au-delà de ce lot)

- Créer les 3 PNG d'icônes déclarées dans `manifest.webmanifest`.
- Décider et créer la coquille PWA statique réelle (page(s) servie(s) en
  Phase 2 hors `server.py`) — actuellement seul `index.html` V1 existe, non
  modifié par ce lot.
- Ajouter dans `app.js` les 2-3 lignes d'appel décrites en §3 (à faire dans
  un lot dédié à la « chirurgie minimale », avec revue explicite — ce lot-ci
  ne les ajoute pas).
- Régénérer `PRECACHE_URLS` (service-worker.js) depuis la liste réelle
  d'assets d'un build, idéalement automatiquement.
- Écran de démarrage réel (UI) consommant `chooseStartMode`.
- Brancher `src/migration/v1-import.js` derrière le choix "create"/"join"
  quand une base V1 existante doit être reprise (docs/next/01 §19).

## 7. Tests navigateur nécessaires avant production

Selon `docs/next/07_TESTS_ET_RECETTE.md` §10 (Tests PWA), non couverts par
`node --test` (nécessitent un vrai navigateur/Playwright) :

- première visite en ligne (install du SW, precache réussi) ;
- installation de la PWA (bannière/critères d'installabilité remplis) ;
- ouverture hors ligne après un premier chargement réussi ;
- détection d'une nouvelle version (`onUpdateAvailable` déclenché) sans
  rechargement automatique ;
- rechargement explicite après clic utilisateur → nouveau SW actif,
  `IndexedDB` conservé (aucune perte de données locales à travers la mise à
  jour) ;
- nettoyage effectif de l'ancien cache après `activate` ;
- comportement en navigation privée (certains navigateurs restreignent
  IndexedDB/SW) signalé clairement à l'utilisateur si non supporté ;
- vérifier qu'aucune requête `/api/*` n'est jamais servie depuis le cache
  (toujours réseau, y compris en cas d'échec — pas de fausse réponse offline
  sur des données métier).

## 8. Rappels de sécurité (docs/next/05 §11-12)

- CSP stricte, aucun `unsafe-inline`, aucune dépendance chargée depuis un
  CDN pour les fonctions vitales (CDC §18 : « aucun CDN requis »).
- Un Service Worker mal scoppé peut intercepter des requêtes indésirables :
  ce `service-worker.js` ignore explicitement toute requête cross-origin et
  toute méthode autre que `GET`.
- Le Service Worker ne doit jamais mettre en cache une réponse `/api/*`
  (données métier potentiellement déchiffrées côté client) — voir §3 du
  fichier `service-worker.js` lui-même.
