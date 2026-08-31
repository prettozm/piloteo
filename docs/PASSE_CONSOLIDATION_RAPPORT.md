# Pilotéo — Rapport de passe « consolidation + déploiements multiples »

> Passe faisant suite à l'audit technique local-first. Objectif : un même métier
> Pilotéo, plusieurs modes de stockage/déploiement clairement séparés, sans gain
> net de complexité. Rapport structuré selon §20 de la commande de passe.

## 1. Corrections issues de l'audit (P0)

### P0.1 — Causalité des événements (`parentEventId`)
- Chaque événement porte désormais `parentEventId` : l'`eventId` dont il descend
  en ligne directe sur l'entité (`null` pour une création). Posé automatiquement
  par `SyncEngine.createLocalEvent` (= `lastEventId` de l'entité au moment de la
  création).
- `conflict.js#classify` exige `event.parentEventId === current.lastEventId`.
  Un descendant d'une **branche perdante** (même `baseVersion` que le gagnant mais
  issu d'un autre parent) est classé **conflit** et ne devient jamais l'état
  officiel. `baseVersion` est conservé en ceinture-et-bretelles.
- **Compat ascendante** : un événement sans `parentEventId` retombe sur l'ancien
  comportement (`baseVersion` seul).
- Régression exacte de l'audit vérifiée : `tests/next/lineage.test.mjs`
  (`A(base1)`, `B(base1)→conflict`, `B2(parent=B, base2)` → conflit, jamais promu).

### P0.2 — Curseur de synchronisation
- `SyncEngine.pull()` ne **commite le nouveau curseur** que si le batch a été
  traité **sans erreur récupérable**. Un échec `get` transitoire conserve l'ancien
  curseur ; l'événement est ré-annoncé et retenté au pull suivant, les autres déjà
  traités étant sautés via `_seen` (idempotence). Plus de perte silencieuse.
- Test : `tests/next/sync-cursor.test.mjs` (échec fetch → curseur non avancé →
  retry → appliqué).

### Tests & CI
- CI (`.github/workflows/ci.yml`) : job `next` ajouté — `npm ci` (lockfile
  reproductible) + `npm run test:next` (moteur + adaptateurs). Les jobs V1
  (python), e2e, docker et trivy restent en place.

## 2. Architecture

- **Moteur Next canonique** : `src/*` est déclaré référence unique
  (`docs/architecture/MOTEUR_NEXT_CANONIQUE.md`). Le chemin historique/solo
  (`piloteo-events.js`, `local-backend.js`, `sw-solo.js`) devient un **adaptateur
  de compatibilité transitoire** avec `app.js`.
- **Duplication supprimée / restante** : la déduplication complète du bundle
  classique suppose une étape de build (script non-module ne pouvant pas `import`
  les ES modules) — **délibérément différée** (règle « pas de big bang »). Règle de
  sécurité posée : le mode **solo mono-utilisateur** peut rester sur `baseVersion`
  seul (aucune concurrence possible) ; tout chemin **multi-utilisateur** doit
  passer par `src/*` (qui porte P0.1).
- **Responsabilités par mode** (le bon niveau d'abstraction, pas au plus bas) :
  - `LOCAL` → IndexedDB directement, **pas** de StorageAdapter, mono-utilisateur.
  - `SHARED` → `StorageAdapter` → `Folder` | `GoogleDrive`.
  - `HOSTED` → backend V1 (`server.py`) + SQLite, **pas** de StorageAdapter.

## 3. Folder Storage

- **Implémentation** : `src/storage/folder-storage-adapter.js` (conforme au
  contrat `StorageAdapter`), format **event-per-file immuable identique** à
  l'adaptateur Drive (mêmes helpers `buildDrivePath`) :
  `events/AAAA-MM/<uuid>.piloteo`, `members/`, `keys/epoch-XXXX/`, `workspace/`,
  `licenses/`. Write-once strict. Port filesystem **injecté** (`fsPort`) : Pilotéo
  ne connaît jamais le fournisseur. `NodeFsPort` (`node:fs`) fourni pour tests /
  wrapper desktop.
- **Curseur** : énumération **complète** à chaque `listChanges` (pas de high-water
  lexicographique — sûr pour un dossier synchronisé de l'extérieur, où un fichier
  peut arriver en retard). Déduplication par `SyncEngine._seen`.
- **Limitations** : le port **navigateur** (File System Access API) n'est pas
  encore câblé (seul le port Node existe) ; l'intégration UI du choix de dossier
  reste à faire ; `share`/`revoke` sont des no-op (le partage est délégué au
  fournisseur de synchro / à l'OS).
- **Navigateurs/OS** : File System Access API = Chromium desktop
  (Chrome/Edge/Opera) ; **Firefox/Safari non**. Cible naturelle : Windows +
  Edge/Chrome (l'environnement OneDrive/SharePoint typique). Un wrapper desktop
  ne serait requis que pour Firefox/Safari ou pour éviter la re-permission.
- **Comportement avec dossier synchronisé** : chaque événement = un fichier au nom
  unique jamais réécrit → l'outil de synchro transporte des fichiers distincts,
  **pas de conflit fichier** ; Pilotéo assure ensuite validation/causalité/conflit/
  projection. Guide : `docs/modes/FOLDER_STORAGE.md`.

## 4. SharePoint

- **Résultat de l'étude** (`docs/SHAREPOINT_FOLDER_STORAGE_STUDY.md`) : verdict
  **GO sous conditions**.
- **Chemin recommandé** : SharePoint → **synchronisation OneDrive existante** du
  client → dossier local → `FolderStorageAdapter`. **Sans** Microsoft Graph, sans
  App Registration Entra, sans accès au tenant. Pilotéo ne voit qu'un dossier.
- **Conditions** : poste **Windows + Edge/Chrome** ; fichiers Pilotéo épinglés
  « Toujours conserver sur cet appareil » (éviter les placeholders non hydratés
  hors ligne) ; aucun fichier partagé réécrit ; respect des contraintes SharePoint/
  Windows (chemin 260, caractères interdits, seuil de vue 5000, versioning).
- **À valider chez un utilisateur réel** : comportement exact des Fichiers à la
  demande hors ligne, propagation/latence, absence de conflit sur des fichiers
  réellement immuables, quotas et versioning sur une vraie bibliothèque d'entreprise.

## 5. Google Drive

- **État du câblage** : `GoogleDriveStorageAdapter` reste un squelette conforme au
  contrat (helpers de chemins purs testés ; méthodes réseau `NotWiredError`). Le
  spike technique manuel (OAuth `drive.file`, création/lecture d'un blob, dossier
  `events/` + `.piloteo`) a été **validé côté utilisateur** avec son compte.
- **Ce qui marche sans GCP** : tout le moteur, via le gating — `google-drive`
  **sans** `GOOGLE_CLIENT_ID` retombe sur un adaptateur **mémoire/fake** (aucun
  appel réseau). `src/config/runtime-config.js` + `src/storage/storage-factory.js`.
- **Ce qui attend seulement le Client ID** : instancier le vrai
  `GoogleDriveStorageAdapter` (client id présent + `oauthTokenProvider` fourni par
  l'app). Le câblage REST complet (files.create/get/list, pagination, refresh
  token, retries) reste le lot dédié ultérieur.

## 6. Hosted

- **Package produit** : déjà complet et **portable** (aucun fournisseur en dur) —
  `Dockerfile`, `docker-compose.yml`, `.env.example`, `entrypoint.sh`. Consolidé
  par l'ajout de `README_DEPLOY.md`.
- **Commande de lancement** : `docker compose up -d`.
- **Prérequis** : Docker + docker compose ; un reverse proxy HTTPS côté hébergeur
  (Caddy/Nginx/Traefik) ; volumes persistants `data` (SQLite) et `backups` ;
  secrets via `.env` non commité ; port configurable (défaut 8080) ; healthcheck
  `/api/health`.
- **Docs** : `docs/deployment/HOSTED_GENERIC.md` (contrat de référence),
  `docs/deployment/FLY.md` et `docs/deployment/OVH_VPS.md` (exemples courts du
  **même** package — pas de « backend Fly » ni « backend OVH » spécifique).

## 7. Déployeur

- **Contrat proposé** : `docs/DEPLOYER_CONTRACT.md`. Le déployeur pose **une**
  question (« Comment souhaitez-vous utiliser Pilotéo ? » : Local / Dossier /
  Google / Hosted) puis se borne à **choisir, valider, écrire la config, lancer**
  le package Hosted le cas échéant. Il ne réimplémente jamais le métier.
- **Configuration attendue par mode** (forme de `runtime-config.js`) :
  - Local : `{ mode:"local", storage:{ provider:"indexeddb" } }`
  - Folder : `{ mode:"shared", storage:{ provider:"folder" } }`
  - Google : `{ mode:"shared", storage:{ provider:"google-drive", googleClientId:"..." } }`
  - Hosted : `{ mode:"hosted", endpoint:"https://..." }`
  - Variante variables plates : `PILOTEO_MODE` / `PILOTEO_STORAGE` /
    `GOOGLE_CLIENT_ID` / `PILOTEO_ENDPOINT` (`configFromEnv`).

## 8. Tests — liste exacte et résultats

| Suite | Commande | Résultat |
|---|---|---|
| Moteur Next + adaptateurs (node:test) | `npm run test:next` | **189 / 189 ✅** |
| V1 serveur (python) | `python3 -m unittest discover -s tests` | **52 / 52 ✅** |
| Export V1 (python) | `python3 -m unittest discover -s tests/v1_export` | **19 / 19 ✅** |

Nouveaux fichiers de test de la passe : `lineage.test.mjs` (P0.1),
`sync-cursor.test.mjs` (P0.2), `folder-storage.test.mjs` (matrice write/list/read/
duplicate/restart + intégration SyncEngine-sur-dossier), `config-factory.test.mjs`
(4 modes + gating Google). Total moteur Next : 189 (contre 175 avant la passe).

## 9. Dette

**Bloquant** (avant toute promesse commerciale) :
- Revue de sécurité dédiée de la crypto (Ed25519 / AES-256-GCM / X25519+HKDF) —
  reste **expérimentale**. Aucune promesse de chiffrement tant que ce gate n'est
  pas franchi (`docs/architecture/CRYPTO_TRUSTED_VS_ENCRYPTED.md`).

**Utile prochainement** :
- Port navigateur **File System Access** pour le mode Dossier (+ intégration UI du
  choix de dossier et de la re-permission).
- Câblage REST **Google Drive** réel (OAuth, files.*, pagination, refresh, retries)
  + tests de la matrice Drive.
- Étape de **build/bundler** pour dédupliquer le moteur classique vers `src/*`
  (convergence event-first du mode solo).
- Validation SharePoint sur un vrai poste d'entreprise.

**Volontairement différé** (hors périmètre de cette passe) :
- Gros installeur/déployeur universel (seul le contrat est documenté).
- SaaS, Stripe, portail client, Microsoft Graph / Entra, connecteur SharePoint
  spécifique, CRDT, P2P, features Team complètes.

## 10. Prochaine étape proposée (UNE seule — non implémentée)

**Implémenter le port navigateur File System Access pour le mode Dossier**, puis
brancher un choix de dossier dans l'UI, afin de rendre le mode Dossier
**réellement utilisable de bout en bout dans le navigateur** (là où le mode a le
plus de valeur : SharePoint-via-OneDrive sans intégration SI). C'est le plus court
chemin entre « adaptateur testé en Node » et « un utilisateur Windows/Edge choisit
son dossier synchronisé et travaille ». Le `FolderStorageAdapter` et son contrat de
port sont déjà prêts ; il ne resterait qu'à fournir une implémentation du port
au-dessus de `showDirectoryPicker()` et à persister le handle.

> À valider avant implémentation — non engagé automatiquement.
