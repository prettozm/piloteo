# Contrat — Point 4 : Google Drive en écriture vive + conflits & « lock files »

> Câble RÉELLEMENT le transport Drive dans `google-drive-adapter.js` (aujourd'hui
> squelette `NotWiredError`), fournit un provider de token OAuth navigateur, et
> RÉPOND explicitement à la question conflits / lock files. `app.js`/`server.py`
> intacts. Client ID OAuth (public, SPA) fourni par la config runtime.

## 0. Rappel du modèle (pourquoi c'est simple et sûr)

Le journal est **event-per-file immuable** : chaque événement est un fichier
unique nommé par son `eventId` (`putImmutable`, write-once). Conséquence directe :
**deux membres qui écrivent en même temps produisent deux fichiers différents** —
il n'y a JAMAIS d'écrasement concurrent d'un même fichier d'événement. La
convergence se fait à la **projection** par le réducteur + `classify` (déjà
construits, identiques aux modes Dossier/Org). Drive n'a donc PAS besoin de
verrous pour le log.

## 1. Câblage REST de `GoogleDriveStorageAdapter` (garder les helpers purs existants)

Implémenter, en `fetch` + `await this._oauthTokenProvider()` (token jamais
persisté/loggé) :
- `connect()` : résout/crée l'arbre de dossiers du workspace (racine
  `rootFolderId` → `events/`, `members/`, `keys/`, `licenses/`, `workspace/`),
  met en cache `nom→fileId`. Sur Shared Drive, utiliser `writeParams()`/`queryParams()`.
- `putImmutable(kind,id,blob)` : **idempotent / write-once**. AVANT `files.create`,
  interroger le dossier cible pour un fichier du nom `fileNameForKind(kind,id)` ;
  s'il existe déjà → **succès idempotent** (ne PAS créer de doublon) ; sinon créer
  (upload multipart). Résout le « duplicate upload on retry après timeout ».
  Si le contenu existant diffère de `blob` pour un `kind` immuable (event/key) →
  lever une erreur `IMMUTABLE_CONFLICT` (ne jamais écraser un immuable).
- `get(kind,id)` : localiser le fichier par nom dans son dossier, `alt=media`.
  Absent → `null` (pas une exception).
- `listChanges(cursor)` : lister les fichiers d'`events/` (récursif mensuel)
  ordonnés par `createdTime,name` ; `cursor` = dernier `{createdTime,id}` vu ;
  ne renvoyer que les plus récents ; renvoyer un nouveau cursor. (Le curseur
  robuste P0.2 côté SyncEngine gère l'avancement ; ici on fournit un flux ordonné
  stable et **complet** — ne jamais sauter un event à cause d'une pagination
  partielle : suivre `nextPageToken` jusqu'au bout avant de renvoyer.)
- `readMetadata(kind,id)`, `health()` (un `about.get`/`files.list` léger),
  `share`/`revoke` : peuvent rester déclaratifs si hors scope, mais NE doivent
  plus lever `NotWiredError` pour les chemins ci-dessus.
- **Erreurs HTTP** : 401/403 → `AUTH_ERROR` (re-demander un token) ; 404 → `null`
  sur get, erreur sinon ; 429/5xx → **retry** avec backoff exponentiel + jitter
  (≤ 4 essais) ; l'idempotence de `putImmutable` rend le retry sûr.

## 2. Provider de token OAuth navigateur — `piloteo-drive-bridge.mjs` (racine, module)

- Utilise Google Identity Services **token model** (comme `tools/team-spike`) :
  `google.accounts.oauth2.initTokenClient({ client_id, scope:"…/auth/drive.file" })`.
- `client_id` vient de la **config runtime** (`GOOGLE_CLIENT_ID`) — jamais en dur
  dans le module ; si absent, le mode Drive est indisponible (retombée
  mémoire/fake déjà en place dans `storage-factory`).
- Expose `window.PiloteoDrive.oauthTokenProvider()` → Promise<accessToken> :
  renvoie un token en cache s'il n'est pas expiré, sinon relance
  `requestAccessToken()` (interaction utilisateur possible). **Token jamais
  persisté** (mémoire de page uniquement), jamais loggé.
- Expose `createDriveEngine({ rootFolderId, driveId? })` construisant un
  `GoogleDriveStorageAdapter` + un « engine » réutilisant le même pont que
  Dossier/Org (SyncEngine trusted / solo-store), pour que `local-backend.js`
  route `/api/state` dessus **exactement comme le mode Dossier** (409 sur conflit).

## 3. Conflits — réponse explicite (à documenter dans le contrat ET le code)

- **Événements** : aucun conflit d'écriture possible (fichiers uniques immuables).
  Conflit **métier** (deux modifs logiques de la même entité) → résolu par
  `classify` à la projection ; `PUT /api/state` renvoie **409** avec l'état
  rechargé (réutiliser le mapping Dossier/Org de 1b), jamais 200 silencieux.
- **Manifeste / genesis** : write-once (`putImmutable` idempotent) — le 2e
  créateur détecte l'existant et NE l'écrase pas.
- **Rotation d'epoch / clés** : write-once par fichier de clé ; le perdant d'une
  course détecte le fichier existant et se réconcilie (pas d'écrasement).

## 4. « Lock files » — décision argumentée (doc `docs/next/DRIVE_CONFLITS_LOCKS.md`)

Position : **PAS de fichiers de verrou (lock files).** Justification à écrire :
1. Drive/OneDrive/SharePoint n'offrent **pas de primitive de verrou atomique**
   inter-clients ; un lock-file n'est qu'un fichier ordinaire → deux clients
   peuvent le créer « en même temps » (course), et il **reste bloqué** (stale) si
   un client crashe/part offline → interblocage sans propriétaire.
2. Le modèle append-only immuable **rend le verrou inutile** : on n'a jamais à
   modifier un fichier existant, donc rien à protéger en exclusion mutuelle.
3. Là où une exclusion est réellement nécessaire (manifeste, clé d'epoch), on
   utilise la **création write-once** (create-if-absent) + détection du perdant,
   pas un verrou. Documenter la fenêtre de course résiduelle (deux `create`
   simultanés du même nom) et sa résolution : les deux fichiers immuables sont
   signés ; la projection déterministe en garde un ; l'autre est un doublon inerte
   détecté par idempotence.
4. Comparaison honnête : quand un lock aurait-il aidé ? seulement un modèle
   « single mutable file » (ce qu'on a précisément évité). Conclusion : lock-free
   par construction ; c'est un **choix**, pas un manque.

## 5. Config / gating

- `GOOGLE_CLIENT_ID` présent → mode Drive sélectionnable (Réglages : la ligne
  « Google Drive » passe de « Bientôt » à activable) ; absent → indisponible,
  retombée mémoire/fake (inchangé). Aucune régression solo/dossier/org.
- `pages.yml` embarque `piloteo-drive-bridge.mjs`. SW précache mis à jour (bump).

## 6. Tests

`tests/next/drive-adapter-live.test.mjs` (node:test) contre un **fetch mocké**
simulant l'API Drive (pas de réseau) :
1. `connect` crée/résout l'arbre (create appelé seulement pour les dossiers absents).
2. `putImmutable` d'un event → `files.create` multipart dans `events/AAAA-MM/`.
3. `putImmutable` **répété** (retry) du même id → **pas** de 2e create (idempotent,
   dédup par nom) → un seul fichier.
4. `putImmutable` du même id avec contenu **différent** (immuable) → `IMMUTABLE_CONFLICT`.
5. `get` d'un id absent → `null` ; présent → contenu.
6. `listChanges` suit `nextPageToken` jusqu'au bout (ne saute aucun event sur 2 pages).
7. 429 puis 200 → retry réussi (≤ 4 essais, backoff appelé).
8. 401 → `AUTH_ERROR` (déclenche re-token).
`npm run test:next` reste vert.

`docs/next/DRIVE_LIVE_MANUAL.md` — **checklist navigateur réelle** (l'OAuth
interactif ne peut pas être automatisé ici) : avec `GOOGLE_CLIENT_ID` réel +
compte test, dérouler create org sur Drive / inviter / rejoindre / écrire /
concurrence 2 onglets → 409, et cocher la matrice Drive (My Drive, Shared Drive,
token expiré → re-consent, offline). Réutilise l'acquis prouvé par `tools/team-spike`.

## 7. Contraintes

- `app.js`/`server.py` intacts. Client ID jamais en dur (config runtime).
- Token OAuth jamais persisté ni loggé. Aucun `client_secret` (SPA/PKCE token model).
- Réutiliser helpers purs existants, SyncEngine trusted, mapping 409 de 1b.
