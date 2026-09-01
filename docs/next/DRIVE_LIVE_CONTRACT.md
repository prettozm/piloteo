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

## 8. Révision post-revue adverse (obligatoire — corrige des failles confirmées)

Le contrariant a produit des repros exécutables. Corrections EXIGÉES :

- **8a. `listChanges` — clé de curseur = clé de tri (bug réel #4/#5).** Le tri et
  l'avancement du curseur DOIVENT utiliser la MÊME clé composite de bout en bout.
  Aujourd'hui le tri est `(createdTime,name)` mais le filtre compare `f.id` : sur
  **égalité de `createdTime`**, un event neuf peut être sauté DÉFINITIVEMENT (le
  curseur ne recule jamais) ou un event déjà vu redélivré à l'infini. Choisir une
  clé totale stable — recommandé `(createdTime, fileId)` partout (tri ET curseur),
  et **dédupliquer par nom de fichier / eventId** en sortie (un doublon physique ne
  doit jamais produire deux entrées logiques). Tests requis : deux events de MÊME
  `createdTime` → aucun sauté, aucun redélivré, curseur monotone.

- **8b. Arbre de dossiers & singletons = réconciliation déterministe (races #1/#2/#3).**
  `connect()`/`_ensureFolder` et les fichiers à **nom constant** (`manifest.piloteo`,
  `current.license`) sont une **ressource mutable partagée** : deux clients qui
  initialisent le même workspace en même temps peuvent créer des dossiers dupliqués
  (split-brain : events d'un client invisibles à l'autre) ou deux singletons
  divergents. À la **résolution** d'un dossier/singleton par nom sous un parent, si
  plusieurs correspondent, choisir DÉTERMINISTEMENT le **plus ancien** par
  `(createdTime, id)` et l'utiliser de façon cohérente (tous les clients convergent
  sans verrou). Pour un immuable à nom constant dont deux versions **différentes**
  coexistent → détecter et lever `IMMUTABLE_CONFLICT` à la lecture (ne jamais
  renvoyer silencieusement l'une ou l'autre au hasard). `putImmutable` reste
  best-effort idempotent (la course résiduelle est rattrapée par la réconciliation
  à la lecture). Tests requis : double `connect()` concurrent → une seule vue
  convergente des dossiers ; double manifeste divergent → `IMMUTABLE_CONFLICT` détecté.

- **8c. Doctrine « lock-free » — corriger l'over-claim.** Mettre à jour
  `DRIVE_CONFLITS_LOCKS.md` : le **journal append-only** est lock-free (events à
  UUID uniques). MAIS l'**échafaudage de dossiers** et les **singletons à nom
  constant** sont mutables partagés et reposent sur la **réconciliation déterministe
  (oldest-wins)**, pas sur des verrous — et NON sur l'affirmation « rien à protéger ».
  Documenter la fenêtre de course résiduelle et sa convergence à la lecture suivante.

- **8d. 403 : distinguer auth et quota (bug réel #6).** `_fetchWithRetry` ne doit
  mapper en `AUTH_ERROR` que les 403 d'authentification/permission. Inspecter
  `body.error.errors[].reason` : `rateLimitExceeded`/`userRateLimitExceeded`/
  `dailyLimitExceeded` → traiter comme 429 (retry + backoff), pas comme une erreur
  d'auth. Test requis : 403 quota puis 200 → succès après retry ; 403 authError →
  `AUTH_ERROR` immédiat.

- **8e. Robustesse du harnais** : `tests/next/helpers/fake-drive.mjs` — le parseur
  `parentMatch` doit gérer l'échappement comme `nameMatch` (un id contenant
  `' in parents` ne doit pas fausser le simulateur). Fiabilise les tests, ne masque
  aucune faille de prod.

## 9. Révision post-revue adverse — round 2 (obligatoire)

Le contrariant a produit 6 nouvelles repros exécutables (`tests/next/attack-p4r2-drive-*.test.mjs`). Corrections EXIGÉES :

- **9a. `listChanges` ne doit JAMAIS exclure un event définitivement (bug de fond #1).**
  `createdTime` est assigné par Drive, NON monotone avec l'ordre logique, et
  `files.list` est éventuellement cohérent : un fichier peut apparaître AVEC un
  `createdTime` INFÉRIEUR au watermark déjà émis → le filtre `createdTime <
  cursor` le saute pour toujours. VÉRIFIÉ dans ce dépôt : le SyncEngine déduplique
  déjà toute re-livraison (`_seen: Set<eventId>`, sync-engine.js:57-58,365) et
  l'EventLog par `eventId` (`duplicate:true`, event-log.js:120). DONC la re-livraison
  est SANS DANGER, et la seule faute grave est de SAUTER. Corriger ainsi : la
  correction PRIME sur l'efficacité — `listChanges` retourne l'ensemble ordonné
  **complet** des events (énumération intégrale, pagination suivie jusqu'au bout),
  déterministe par `(createdTime, id)`. Le `cursor` devient une optimisation
  FACULTATIVE qui ne peut être qu'une **borne basse conservatrice ne pouvant jamais
  exclure** un event non prouvé-livré (au besoin : rembobinage de sécurité + dédup
  par eventId côté sortie). Interdit : tout chemin où un event réel n'est jamais
  renvoyé. Test : un event au `createdTime` INFÉRIEUR au watermark, jamais vu →
  DOIT être livré (pas sauté).

- **9b. `connect()` — corriger l'over-claim ET permettre la convergence d'une instance vivante (#2).**
  Aujourd'hui `connect()` est un no-op définitif (`_connected=true`) et
  `_topFolders`/`_folderCache` ne s'invalident jamais : une instance A qui a fini
  son balayage reste bloquée sur SON dossier même si un dossier réellement plus
  ancien devient visible ensuite → ses écritures futures restent invisibles à B.
  DEUX corrections : (1) rendre HONNÊTE `DRIVE_CONFLITS_LOCKS.md` (ne pas affirmer
  une « convergence garantie à la prochaine résolution » qui n'existe pas pour une
  instance déjà vivante) ; (2) permettre une **re-résolution paresseuse** des
  dossiers top-level (TTL court sur `_topFolders`, ou invalidation quand une
  divergence est détectée) pour qu'une instance vivante puisse converger vers le
  plus-ancien, oldest-wins, sans redémarrage. Test : un dossier plus ancien
  apparaissant après connect() → A finit par l'adopter.

- **9c. `_reconcileFileCandidates` — ne pas casser une lecture à cause d'un orphelin
  illisible (#3).** Télécharger le **gagnant** (oldest) d'abord ; ne télécharger les
  autres candidats (détection de divergence) qu'en **best-effort**, en absorbant un
  échec (5xx/403) sur un NON-gagnant sans faire échouer la lecture. Un 404 sur un
  candidat = disparu (déjà OK). Test : gagnant lisible + doublon surnuméraire en 5xx
  → `get()` réussit et renvoie le gagnant.

- **9d. Comparaison d'immutabilité — éviter le faux `IMMUTABLE_CONFLICT` (#4).**
  Deux blobs logiquement identiques mais d'octets différents (ordre de clés JSON)
  ne doivent pas déclencher un conflit. Résolution PRÉFÉRÉE : garantir une
  **sérialisation canonique** (clés triées, cf. `stableStringify` déjà présent) au
  point d'écriture des singletons (bridge/engine) pour que « identique logiquement »
  ⇒ « octets identiques » — l'adaptateur garde alors une comparaison byte-exacte
  (correcte pour un immuable signé). Documenter l'exigence de sérialisation
  canonique pour les singletons. Test : deux écritures du même singleton logique
  via le chemin normal → pas de faux conflit.

- **9e. 403 — reconnaître le format `google.rpc.Status` et prioriser l'auth (#5/#6).**
  `is403QuotaBody` doit AUSSI reconnaître `error.status === "RESOURCE_EXHAUSTED"`
  (format moderne), en plus de `error.errors[].reason`. Et en cas de MÉLANGE
  auth+quota dans `errors[]`, un motif d'auth **permanent** (`authError`/
  `insufficientPermissions`) PRIME → `DriveAuthError` immédiat (pas de retries
  gaspillés). Tests : 403 `RESOURCE_EXHAUSTED` → retry ; 403 mixte auth+quota →
  `AUTH_ERROR` immédiat, zéro retry.

Garder tous les tests `attack-p4r2-*` en place, assertions réécrites pour PROUVER
le correctif (jamais affaiblies). `npm run test:next` reste vert.

## 10. Révision post-revue adverse — round 3 (obligatoire — perte de données permanente)

Le contrariant r3 a prouvé (`tests/next/attack-p4r3-drive-orphan-topfolder.test.mjs`)
une faille SÉRIEUSE : la réconciliation oldest-wins du §9b a fait converger les
ÉCRITURES vers le dossier top-level le plus ancien, mais les LECTURES
(`listChanges`, `get`, `readMetadata`, `exists`) ne parcourent QUE le sous-arbre de
ce gagnant. Conséquence : un event ou un singleton écrit dans un dossier top-level
DUPLIQUÉ « perdant » (orphelin issu d'une course de création) devient **invisible
en permanence pour TOUS les clients** (pas seulement transitoirement, et même pour
une instance connectée bien après stabilisation) — y compris l'instance qui vient
de l'écrire avec succès (`get()` renvoie `null` sur un manifeste physiquement
présent). Viole §9a (« tout chemin où un event réel n'est jamais renvoyé est
interdit ») et §2bis de `DRIVE_CONFLITS_LOCKS.md`.

Correction EXIGÉE — **les lectures unissent tous les dossiers de même nom** (pendant
lecture du oldest-wins en écriture) :

- **10a. `listChanges`** : énumérer les events de **TOUS** les dossiers top-level
  nommés `events` sous la racine (`_findAllFolders`, déjà présent), et de tous
  leurs sous-dossiers mensuels dupliqués, puis fusionner + dédupliquer par nom
  d'event/eventId avant tri. Aucun event physiquement présent sous la racine ne
  doit rester non renvoyé, quel que soit le dossier dupliqué où il vit.
- **10b. `get`/`readMetadata`/`exists`** : avant de conclure à une absence,
  chercher le fichier dans **tous** les dossiers top-level candidats du kind (et
  leurs sous-dossiers dupliqués), pas seulement le gagnant. Si le même
  `(kind,id)` existe dans plusieurs dossiers avec des contenus divergents →
  `IMMUTABLE_CONFLICT` (réconciliation §9d), jamais un `null` silencieux ni un
  choix arbitraire.
- **10c. Doc** : mettre `DRIVE_CONFLITS_LOCKS.md` §2bis en accord — la convergence
  ne repose plus sur « le perdant est un orphelin inoffensif » (faux : son contenu
  serait perdu) mais sur « écriture converge vers le plus-ancien ET lecture unit
  tous les dossiers dupliqués → aucun contenu échoué ». Documenter le coût
  (lecture O(dossiers dupliqués)) comme choix assumé correction > efficacité.

Garder le repro `attack-p4r3-*` en place, assertions réécrites pour prouver que
l'event/manifeste orphelin est désormais VU (plus d'invisibilité permanente).
`npm run test:next` reste vert. NE touche pas local-backend.js. Ne commit pas.
